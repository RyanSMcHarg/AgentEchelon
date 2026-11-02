import { personIdFromArn } from './person-arn.js';
/**
 * SHOULD THIS TURN CONTINUE IN THIS CONVERSATION, RATHER THAN BE OFFERED A NEW ONE?
 *
 * One named decision with one caller, deliberately, rather than a boolean assembled inside the drift
 * call's argument list. What it answers is a product question that is going to get harder, and the
 * point of giving it a name now is that the harder version can replace its BODY without any call site
 * being unpicked.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS TODAY: AN INTERIM, AND IT IS DELIBERATELY BLUNTER THAN THE INTENT.
 * ---------------------------------------------------------------------------
 *
 * Today it says: work is running in this conversation (or finished here moments ago), therefore
 * continue here and do not run the cosine drift path. ANY live task counts, whatever the person just
 * said. That is a real simplification and it is chosen, not overlooked - it errs toward continuity,
 * and continuity is the cheaper failure. Interrupting an answer the assistant just asked for with an
 * offer to talk somewhere else costs the person the turn they were in the middle of; continuing a
 * conversation that had genuinely moved on costs them one un-offered split, which they can ask for
 * outright at any time (the explicit-routing fast path is checked before this and is never
 * suppressed).
 *
 * THE COST OF THE SIMPLIFICATION, stated so nobody has to rediscover it: while a task is open, a
 * genuinely new subject is never offered a conversation of its own. That case is real and the target
 * design below does not accept it.
 *
 * ---------------------------------------------------------------------------
 * THE TARGET: TWO QUESTIONS, NOT ONE (maintainer).
 * ---------------------------------------------------------------------------
 *
 * A message that looks unrelated to the active TASK is not thereby unrelated to the CONVERSATION, and
 * collapsing those two is what this interim does:
 *
 *  1. Unrelated to the task, still related to the conversation ⇒ break out of the task and carry on
 *     here. No drift offer, no new conversation.
 *  2. Unrelated to the task AND unrelated to the conversation ⇒ that is real drift. Offer a new
 *     conversation; if the person declines, break out of the task and carry on here.
 *
 * So the end state is task-relatedness first, then conversation-relatedness - two axes, where today
 * there is one axis (message against the conversation summary) plus a binary "a task is live, skip
 * drift entirely". Read this file as the seam that becomes axis one, not as the intended behavior.
 *
 * WHEN IT IS BUILT, the change is inside this function: `TaskContinuityInput` gains what the message
 * is related to, the body stops treating "a task exists" as the answer, and `router-agent-handler.ts`
 * and `live-drift-flow.ts` keep passing and consuming exactly what they pass and consume now. What it
 * NEEDS and does not have is a signal: drift compares the message embedding against the CONVERSATION
 * SUMMARY embedding, and nothing anywhere embeds a task, so task-relatedness has no input at all
 * today. See SPEC-DRIFT-CONVERGENCE ("Active-Task Suppression").
 */

/** Which evidence produced a continue-here decision. Reporting only; it never changes the outcome. */
export type TaskContinuitySignal = 'live' | 'recently_ended';

export interface TaskContinuityInput {
  /**
   * This channel has a task with status `pending` or `in_progress`, WHOEVER holds it.
   *
   * Not owner-scoped, and that is the whole point of the field: ownership moves to the person only at
   * an `awaits` boundary (ADR-024), so an owner-keyed version made this decision depend on every
   * state remembering to declare that flag - and `report_generation.drafting_outline` did not, which
   * is how a direct answer to the assistant's own outline question was answered with an offer to
   * split the conversation.
   */
  liveTaskInChannel: boolean;
  /**
   * A task in this channel reached a terminal state within the deployment's recently-ended window,
   * confirmed from the task's own `stateHistory` (SPEC-TASK-STATE-TRANSITIONS §6).
   *
   * Separate from the live signal because it answers a different turn: the work is over, and the
   * message is about what was just delivered ("Where is the file?"). Every task lookup filters to
   * active statuses, so nothing about a finished task reaches the live signal.
   */
  recentlyEndedTaskInChannel: boolean;
}

export interface TaskContinuityDecision {
  /**
   * Continue in this conversation: do not run the cosine drift path this turn.
   *
   * Suppresses COSINE only. The explicit-routing fast path runs before it, so someone who deliberately
   * asks for a separate conversation still gets one, and a long-running task never becomes a trap.
   */
  continueHere: boolean;
  /** What decided it, for the skip counter. Undefined when the turn is not continuing on this basis. */
  signal?: TaskContinuitySignal;
}

/**
 * Resolve the decision. PURE - every input is resolved by the caller from reads it already makes, so
 * this adds no lookup of its own and can be exercised without a deployment.
 *
 * Live work wins the reporting when both hold: a conversation with something running is described by
 * what is running, not by what finished before it.
 */
export function resolveTaskContinuity(input: TaskContinuityInput): TaskContinuityDecision {
  if (input.liveTaskInChannel) return { continueHere: true, signal: 'live' };
  if (input.recentlyEndedTaskInChannel) return { continueHere: true, signal: 'recently_ended' };
  return { continueHere: false };
}

/**
 * THE FINISHED TASK A FOLLOW-UP IS ABOUT, WHEN IT CAN STILL BE REVISED. A delivered report stays
 * revisable, so a person can keep improving it in the same conversation.
 *
 * Delivery closes a report, so a change is almost always asked for after the task has ended, and every
 * live-task lookup filters an ended task out. The turn then had no task, so "can you add a churn
 * section?" opened new work or was answered with no way to revise the report it was about. A terminal
 * state that declares `reopens` keeps answering as the follow-up's subject instead, and the turn is
 * handed the task with the reopen as an available move. Whether to TAKE it is the model's, on the turn
 * that has the person's words; nothing here reads them.
 *
 * Every condition is a fact the router already holds:
 *  - the ending is confirmed from the task's own log and lies within `RECENTLY_ENDED_TASK_WINDOW_MINUTES`
 *    (the caller passes `endedWithinWindow`), the same bound the drift suppression uses, so a follow-up
 *    reaches a finished report for exactly as long as it is read as being about it;
 *  - the lifecycle ended as `completed`; a failed or cancelled task is not offered back;
 *  - the state is terminal and declares `reopens`; every other terminal stays final;
 *  - the work belongs to THIS assistant and was requested by THIS sender, so one person's message
 *    cannot reopen another person's report. The sender comes from the message, which Amazon Chime SDK
 *    stamps, never from anything typed;
 *  - the turn is not NEW WORK OF ANOTHER KIND. The caller passes `turnOpensTaskType`, the task type
 *    this turn's intent would open by the router's own opening rule (an intent owns the machine of the
 *    same name, when one exists and the selection allows it), or undefined when the intent opens none.
 *    A turn that would open a DIFFERENT workflow ("now extract the table from this PDF" after a report)
 *    is its own work: attaching the report would make it the turn's active task and the new request
 *    would continue the report's chain instead of opening its own. A turn of the same type, or one that
 *    opens no workflow at all ("can you add a churn section?" classified as general), is still offered
 *    the finished task, and the model decides whether it is a change.
 *

 * A REOPENABLE TASK IS NOT OPEN WORK. Nothing here changes its status; the open-work reads still filter
 * to `pending`/`in_progress`, so a delivered report never appears in anyone's list until a reopen
 * actually moves it.
 *
 * PURE, so each refusal is testable without a deployment.
 */
export function reopenableFollowUpSubject(input: {
  task: {
    taskType?: string;
    taskState?: string;
    status?: string;
    assistantId?: string;
    ownerPersonId?: string;
    userArn?: string;
  } | null | undefined;
  endedWithinWindow: boolean;
  assistantId: string;
  senderSub: string;
  /** The turn's machines: is the state terminal, and what does it reopen into. */
  reopenTargets: (taskType: string, taskState: string) => string[];
  /**
   * The task type this turn's intent would OPEN, or undefined when it opens none. Required, so a caller
   * cannot forget the new-work exclusion by omission.
   */
  turnOpensTaskType: string | undefined;
  /** What a roommate key in `turnOpensTaskType` reads back to if the turn stays here (`keptHereAs` in `opensOtherWorkThan`). */
  keptHereAs?: string;
}): boolean {
  const { task } = input;
  if (!task || !input.endedWithinWindow) return false;
  if (task.status !== 'completed' || !task.taskType || !task.taskState) return false;
  if (input.turnOpensTaskType && !sameWork(input.turnOpensTaskType, input.keptHereAs, task.taskType)) return false;
  if (input.reopenTargets(task.taskType, task.taskState).length === 0) return false;
  if (!input.assistantId || task.assistantId !== input.assistantId) return false;
  const requester = task.ownerPersonId || personIdFromArn(task.userArn) || '';
  return Boolean(input.senderSub) && requester === input.senderSub;
}

/**
 * WHETHER A MESSAGE OPENS OTHER WORK RATHER THAN ANSWERING THE TASK WAITING ON ITS SENDER.
 *
 * A task that awaits a person reads their next message as its answer (ADR-033), and drift stays quiet
 * while it waits (ADR-006). So "Separately, walk me through diagnosing a failed deployment", sent while
 * a report waited on its scope, was worked as a report turn: it was answered, and the troubleshooting
 * it asked for was never opened, listed or tracked (measured live). A message whose intent opens a
 * DIFFERENT task type is new work, and opens its own task; the waiting task stays where it was.
 *
 * Not when the person NAMED the waiting item (a reference or a declared id): they said which work this
 * is. Not for the platform's own machines: an answer to a queue clarification is routinely a whole
 * request, and is the answer. Not in a conversation holding a live duel: the duel owns that exchange,
 * and a side waiting on its initiator must get the answer. The duel is read from the battle record, not
 * from the task: the mirror rows a router lookup returns do not carry `battleId`.
 *
 * `turnOpensTaskType` may be a roommate's key (`delegate__<assistant>__<intent>`): another assistant's
 * work is the clearest case of other work, and it never equals a task type. EXCEPT when the key reads
 * back to the waiting task's own type (`keptHereAs`, `intentKeptHere` in lib/delegation.ts): a roommate
 * advertising the same work as the waiting task does not make the message other work. If the handover
 * then does not happen, the turn is kept here as exactly that type, so setting the waiting task aside
 * would strand its answer while the turn opened a second task of the same kind.
 *
 * PURE, so each exclusion is testable without a deployment.
 */
export function opensOtherWorkThan(input: {
  task: { taskType?: string } | null | undefined;
  /** The task type this turn's intent would OPEN, or undefined when it opens none. */
  turnOpensTaskType: string | undefined;
  /** The person named this item, by reference or declared id. */
  namedByThePerson: boolean;
  platformTaskTypes: readonly string[];
  /** The conversation holds a live duel. */
  inADuel: boolean;
  /**
   * The intent this turn keeps if it stays here (`intentKeptHere`): a roommate key read back into this
   * assistant's taxonomy, otherwise the intent itself.
   */
  keptHereAs: string | undefined;
}): boolean {
  const { task, turnOpensTaskType } = input;
  if (!task?.taskType || !turnOpensTaskType || input.namedByThePerson) return false;
  if (input.inADuel || input.platformTaskTypes.includes(task.taskType)) return false;
  return !sameWork(turnOpensTaskType, input.keptHereAs, task.taskType);
}

/** The turn's work is the task's: its key is the task's type, or what that key reads back to here is. */
function sameWork(turnKey: string, keptHereAs: string | undefined, taskType: string): boolean {
  return turnKey === taskType || (!!keptHereAs && keptHereAs === taskType);
}

/**
 * A STALLED STEP OF THE SPEAKER'S OWN WORK RESUMES, RATHER THAN BEING DECLINED.
 *
 * The one-thread rule (router-agent-handler.ts) declines a message to a task whose next step the assistant
 * owes, because a second turn on running work writes it twice. Measured live: a data extraction's turn
 * showed the records and stopped at `extracting` without advancing; the person's "the results look right,
 * format the table and deliver it" was then either declined or opened a second task, and the extraction
 * never delivered. A step whose turn has ENDED without moving the task is stalled, not running, and its
 * own requester asking for exactly that work is the turn it needs.
 *
 * Resumes only when every one of these holds; anything else keeps the decline:
 *  - the turn queue can say nothing is running: it is on, its state was read, and no turn holds this
 *    assistant's lock here (ADR-033). Off or unreadable cannot tell running from stalled, so it declines;
 *  - the speaker is the task's owner (ADR-024 D8);
 *  - the message is that work: the classifier labeled it as the task's own type (tenet D11, the model
 *    judged relevance; no phrase is matched);
 *  - nothing has been delivered on the task yet. A delivered report with the assistant owing only its
 *    close is the original one-thread case ("is this task complete?" wrote the report again), and it
 *    stays declined.
 */
export function resumesAStalledStep(input: {
  /** The one-thread rule's verdict: the assistant owes the next step. */
  assistantOwesTheStep: boolean;
  turnQueue: { enabled: boolean; busy: boolean; unreadable?: boolean } | null;
  taskOwnerPersonId: string | undefined;
  speakerPersonId: string | undefined;
  /** The classifier labeled this message as the task's own type. */
  labeledAsThisWork: boolean;
  /** Documents already delivered on the task, from its row; null when the row could not be read. */
  deliveries: number | null;
}): boolean {
  if (!input.assistantOwesTheStep) return false;
  const q = input.turnQueue;
  if (!q || !q.enabled || q.unreadable || q.busy) return false;
  if (!input.speakerPersonId || input.taskOwnerPersonId !== input.speakerPersonId) return false;
  if (!input.labeledAsThisWork) return false;
  return input.deliveries === 0;
}

/**
 * THE TASK IS A STALLED-STEP CANDIDATE FOR THIS MESSAGE (`resumesAStalledStep` then decides).
 *
 * A step this assistant holds (its state awaits nobody), of work the speaker owns, and the classifier placed
 * the message as that work. The router asks it wherever the turn finds the task: in this assistant's own
 * partition, or in the person's, where a task whose opening step the assistant works is still filed under
 * its requester. Both reach the same one-thread rule, so both ask the same question.
 */
export function isStalledStepCandidate(input: {
  task: { taskType?: string; ownerPersonId?: string; assistantId?: string } | null | undefined;
  /** The task's current state declares a party it awaits. */
  awaitsAParty: boolean;
  /** This assistant's principal id. */
  selfAssistantId: string;
  speakerPersonId: string | undefined;
  /** The task type this turn's intent opens, and what the intent reads back to here. */
  turnOpensTaskType: string | undefined;
  keptHereAs: string | undefined;
}): boolean {
  const { task } = input;
  if (!task?.taskType || input.awaitsAParty) return false;
  if (task.assistantId && task.assistantId !== input.selfAssistantId) return false;
  if (!input.speakerPersonId || task.ownerPersonId !== input.speakerPersonId) return false;
  return task.taskType === input.turnOpensTaskType || task.taskType === input.keptHereAs;
}
