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
 * THE TARGET: TWO QUESTIONS, NOT ONE (owner).
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
 * drift entirely". Read this file as the seam that becomes axis one, not as the intended behaviour.
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
