/**
 * THE STEP A TASK IS ON, rendered into the turn's system prompt (SPEC-TASK-STATE-TRANSITIONS §9).
 *
 * Every machine renders the same way, whoever declared it: the `## CURRENT TASK` header, the state's
 * declared `prompt`, then the exact legal next states for `advance_task_state`. The platform defaults
 * carry their step instructions as declared `prompt`s like any other machine, so a manager changes what
 * a step says by changing the workflow, and a pack or profile that redeclares one of the default task
 * types has its own prompts rendered, not the platform's.
 *
 * NOTHING HERE KEYS ON A TASK TYPE'S NAME. The text comes from the machine, and the machine is the
 * turn's (ADR-047). A prompt with dynamic content would need a renderer that fills it from the task;
 * no declared prompt has any, so the renderer takes no task and substitutes nothing.
 */
import { confirmStepPassed, deliversDocument, DELIVER_DOCUMENT_TOOL_NAME } from './task-state-machines.js';
import {
  legalTransitionsFrom,
  reopenTargetsFrom,
  recordedTemplateChoice,
  resolveStateTemplate,
  templateChoiceOf,
  templateRefKey,
  templateRefsOfState,
  type TaskStateMachine,
} from './task-state-machines.js';
import { taskHasMachine } from './task-tools.js';
import { isLoadedTemplate, renderTemplateChoice, renderTemplateGuidance, type TurnTemplates } from './document-template.js';

/** What the step's template guidance is rendered from: the turn's loaded templates and the task's record. */
export interface TemplateGuidanceContext {
  templates?: TurnTemplates;
  /** The task's details, where a recorded format choice is read from (SPEC-DOCUMENT-TEMPLATES FR3a). */
  details?: Record<string, unknown>;
}

export function buildTaskSystemPrompt(
  taskType: string,
  taskState: string,
  // THE TURN'S MACHINES, passed rather than defaulted (ADR-047). Read from the compiled platform set
  // while the tool they describe was authorized against the turn's, a deployment whose classification
  // pack adds a state was told a legal target the real graph does not have, `advance_task_state`
  // refused it as an illegal transition, and the machine stalled mid-flow.
  machines: Record<string, TaskStateMachine>,
  templateContext?: TemplateGuidanceContext,
  /**
   * WHETHER A DELIVERING STEP WRITES ITS OWN DOCUMENT on its own model (ADR-064 decision B): the move into it is made
   * without the document, which that step's model declares with `deliver_document`. Absent, the document rides the move.
   */
  documentWrittenOnStep?: (state: string) => boolean,
): string {
  // A type with no machine this turn has no step to describe.
  if (!taskHasMachine(taskType, machines)) return '';
  const statePrompt = machines[taskType]?.states?.[taskState]?.prompt?.trim();
  return `

## CURRENT TASK: ${taskType.replace(/_/g, ' ')} - ${taskState.replace(/_/g, ' ')}`
    + (statePrompt ? `
${statePrompt}` : '')
    // THE DOCUMENT'S DECLARED SHAPE, loaded deterministically, never left to retrieval
    // (SPEC-DOCUMENT-TEMPLATES FR5), and the choice of formats on the step that collects it (FR3a).
    + templateGuidance(machines[taskType], taskState, templateContext)
    + notADeliveringStep(machines[taskType], taskState, documentWrittenOnStep)
    // The machine's EXACT legal next-state names. The declared prompt says what to do but not always
    // the precise state to advance TO, so the model would guess a to_state that is not in the graph;
    // advance_task_state then errors (unknown_state/illegal_transition) and the machine stalls
    // mid-flow. Naming the valid targets verbatim removes the guesswork.
    + taskAdvanceHint(taskType, taskState, machines)
    + pastAConfirmedStep(machines[taskType], taskState, machines, taskType);
}

/**
 * The template part of a step's guidance. On a delivering state that declares a template: the template
 * the task resolves to (the recorded choice, else the default), its structure and section guidance. On
 * the requirements step of a workflow that offers a choice: the formats, or the one already chosen.
 * Nothing for a step that declares neither, so a workflow without templates renders exactly as before.
 */
function templateGuidance(
  machine: TaskStateMachine | undefined,
  state: string,
  ctx: TemplateGuidanceContext | undefined,
): string {
  if (!machine) return '';
  let out = '';
  const choice = templateChoiceOf(machine);
  if (choice && state === choice.step) {
    const loadedByName = Object.values(ctx?.templates ?? {});
    const options = choice.names.map((name) => loadedByName.find((t) => t.name === name) ?? { name, error: 'not loaded' });
    out += renderTemplateChoice(options, choice.defaultName, recordedTemplateChoice(ctx?.details));
  }
  if (!templateRefsOfState(machine.states[state]).length) return out;
  const resolved = resolveStateTemplate(machine, state, ctx?.details);
  if (!resolved || 'choiceRequired' in resolved) return out;
  const loaded = ctx?.templates?.[templateRefKey(resolved.ref)];
  if (isLoadedTemplate(loaded)) return out + renderTemplateGuidance(loaded);
  return `${out}\n\n## DOCUMENT TEMPLATE: ${resolved.ref.name}\nThe template this step's document follows could not be `
    + 'loaded, so the document cannot be delivered in its required format now. Tell the person so; do not '
    + 'write the document.';
}

/**
 * A STEP THAT HANDS OVER NOTHING SAYS SO, in a workflow that does hand something over.
 *
 * Measured live (2026-10-26): at a report's outline step the model wrote the report into its reply and
 * told the person "Your Q2 ARR Executive Summary is ready above", having delivered nothing; the person was
 * told a document existed that did not. The step's own prompt asked for an outline, which the model read
 * past. Read from the machine's declarations (`delivers`), never from a task type's name, so every
 * workflow with a delivering step gets it and a workflow without one renders as before.
 *
 * WHO WRITES THE DOCUMENT IS SAID TOO (ADR-064 decision B): a delivering step this one moves into that writes its own
 * document on a model of its own is entered without the document, so the model running this step is not asked to write
 * a document that step's model writes.
 */
function notADeliveringStep(
  machine: TaskStateMachine | undefined,
  state: string,
  documentWrittenOnStep?: (state: string) => boolean,
): string {
  if (!machine || deliversDocument(machine.states[state])) return '';
  const delivering = Object.entries(machine.states).filter(([, def]) => deliversDocument(def)).map(([name]) => `\`${name}\``);
  if (!delivering.length) return '';
  const nextDelivering = (machine.states[state]?.transitions ?? []).filter((to) => deliversDocument(machine.states[to]));
  const writtenThere = nextDelivering.filter((to) => Boolean(documentWrittenOnStep?.(to)));
  const declaredOnMove = nextDelivering.filter((to) => !writtenThere.includes(to));
  const named = (states: string[]) => states.map((s) => `\`${s}\``).join(' or ');
  const whenReady = writtenThere.length
    ? `If the work is ready to deliver now, advance to ${named(writtenThere)} without a \`document\`: that step writes `
      + `the document on a model of its own and declares it there with \`${DELIVER_DOCUMENT_TOOL_NAME}\``
      + (declaredOnMove.length ? `; a move to ${named(declaredOnMove)} declares the document in that call` : '')
      + '. Otherwise do what this step asks.'
    : 'If the work is ready to deliver now, advance to that step and declare the document in that call; otherwise do '
      + 'what this step asks.';
  return '\n\n**This step hands over no document.** Do not write the deliverable in your reply, and never tell '
    + 'the person it is ready, attached or above: a document exists only once it is declared as the `document` '
    + `from a delivering step (${delivering.join(', ')}). ${whenReady}`;
}

/** The exact legal next states for the model's advance_task_state call, verbatim (no guessing). */
function taskAdvanceHint(taskType: string, taskState: string, machines: Record<string, TaskStateMachine>): string {
  const legal = legalTransitionsFrom(taskType, taskState, machines);
  if (legal.length === 0) {
    // A FINISHED TASK THAT DECLARES A REOPEN is offered it as its one move, and only for a change
    // request. Without naming it the model is told the task is closed, and a change asked for after
    // delivery has nowhere to go. Naming it keeps a delivered report revisable.
    const reopens = reopenTargetsFrom(taskType, taskState, machines);
    if (reopens.length > 0) {
      const names = reopens.map((s) => `\`${s}\``).join(', ');
      return `\n\n**Task state machine:** the task is in \`${taskState}\`, a terminal state: it is finished and delivered. If, and only if, the person is asking for CHANGES to it, call the **advance_task_state** tool with \`to_state\` set to EXACTLY one of ${names} (copy the name verbatim) to reopen it, then make the change and re-deliver. A question about the delivered work, or thanks, is answered without calling the tool.`;
    }
    return `\n\n**Task state machine:** the task is in \`${taskState}\` — a terminal state. Do not call advance_task_state.`;
  }
  const names = legal.map((s) => `\`${s}\``).join(', ');
  return `\n\n**Task state machine:** the task is currently in \`${taskState}\`. When the conversation has actually reached the next milestone, call the **advance_task_state** tool with \`to_state\` set to EXACTLY one of these declared next states (copy the name verbatim): ${names}. These are the ONLY valid targets from here — do not invent or paraphrase a state name. If no milestone has been reached yet, do not call the tool.`;
}

/**
 * THE WAY PAST A STEP THAT IS CONFIRMED ONLY WHEN THE REQUEST IS INCOMPLETE (ADR-064 decision G), named with the brief it
 * needs, read from the machine: which legal move goes past which step, and the needs of that step's `brief`. Nothing for
 * a step with no such move, and nothing where the step is always confirmed, since that move is not legal.
 */
function pastAConfirmedStep(machine: TaskStateMachine | undefined, state: string, machines: Record<string, TaskStateMachine>, taskType: string): string {
  if (!machine) return '';
  return legalTransitionsFrom(taskType, state, machines).map((to) => {
    const step = confirmStepPassed(machine, state, to);
    const def = step ? machine.states[step] : undefined;
    if (!step || def?.confirm !== 'when-incomplete') return '';
    const brief = (def.brief ?? []).map((n) => `"${n}"`).join(', ');
    return `\n\n**Going straight to \`${to}\`.** Only when the request that opened this step already carries the complete `
      + `brief: record every need of this step and each of ${brief} in \`collected\`, each with its source and evidence, and `
      + `advance to \`${to}\` in this turn, without \`${step}\`. If any of them is missing, or the person asked to see the `
      + `brief first, ask for what is missing or advance to \`${step}\`.`;
  }).join('');
}
