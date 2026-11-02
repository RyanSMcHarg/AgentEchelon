/**
 * WHAT IS HAPPENING TO THE QUEUE, SAID WHILE IT HAPPENS (DESIGN 2.4.2).
 *
 * A queue that is being worked looks exactly like a queue that is stuck: the same messages sitting
 * there marked as waiting, for as long as it takes. The person who sent them cannot tell the
 * difference, and the difference is the whole of their experience of it - one is patience, the other
 * is a product that has stopped.
 *
 * Tasks solved this already by carrying a STATE that moves, and a person reads that state to know
 * whether anything is happening. The queue is the same problem and gets the same answer: a small
 * closed vocabulary, moved as the drain reaches each stage, carried on the notice the client is
 * already watching.
 *
 * ── A CLOSED SET, IN ORDER, AND NONE OF THEM SAY WHAT ABOUT ─────────────────────────────────────
 *
 * The stages are ordered because the drain is: the queue is read, the reading is put to the room, any
 * private requests are taken up one to one, and then the queue is emptied. `addressing_private` in
 * particular says only THAT private requests are being handled - never whose, how many, or what
 * about, because the notice is public and naming any of that would publish what the private message
 * exists to keep private.
 */

import { messageTemplateChoice, shippedLineText } from './message-lines.js';
import type { AssistantCopy } from './active-profile.js';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from './task-state-machines.js';

export type QueueStatus =
  /** Held, and nothing has looked at it yet. */
  | 'waiting'
  /** The reading is running: what arrived is being understood. */
  | 'reviewing'
  /** The reading has been put to the room and is waiting on an answer. */
  | 'clarifying'
  /** Targeted requests are being taken up with the people who sent them. */
  | 'addressing_private'
  /** The work exists; the queue itself is being emptied. */
  | 'clearing'
  /** Nothing is waiting any more. */
  | 'settled';

/**
 * THE DRAIN IS A STATE MACHINE, DECLARED THE WAY EVERY OTHER STATE MACHINE HERE IS.
 *
 * Working the queue is a workflow with states, legal moves between them, and a point at which it is
 * over - which is exactly what `TaskStateMachine` already describes, and what `validateTaskStateMachine`
 * already checks. Inventing a second vocabulary for it would mean a second thing to learn, a second
 * place to look, and a second validator to keep honest.
 *
 * WHY IT IS NOT A TASK ROW, THOUGH. Tasks are work somebody owns, appear in their list, and outlive
 * the turn. A drain is a phase of ONE turn: giving every drain a row would put an item in a person's
 * open work for every time an assistant read a queue, describing machinery rather than anything they
 * asked for. So this reuses the FRAMEWORK - the declaration, the validator, the shape of a
 * transition - and keeps the state on the turn record, which is already this path's authority.
 *
 * DECLARED EDGES RATHER THAN AN ORDERING, and the difference is not cosmetic. An ordering says only
 * "later than", which permits a drain to jump straight from waiting to settled and call it progress.
 * The edges say which moves actually exist: a queue reaches `clearing` from a reading or from a
 * conversation, and reaches `settled` only from `clearing`.
 */
/**
 * THE DRAIN MACHINE NOW LIVES WITH THE OTHER MACHINES, and is re-exported here.
 *
 * It became a declared TASK TYPE on 2026-09-03 (ADR-033, "a drain IS a task"), so it belongs in
 * `DEFAULT_TASK_STATE_MACHINES` with everything else the runtime advances - one definition, one
 * validator run, and a profile that ships its own machines can override this one exactly as it can
 * override any other.
 *
 * Re-exported rather than moved silently: every consumer here reads the stage vocabulary from this
 * module, and a definition in two places is a definition that drifts.
 */
export const QUEUE_DRAIN_MACHINE: TaskStateMachine = DEFAULT_TASK_STATE_MACHINES.queue_drain;


/** In the order the drain reaches them, for a client rendering progress rather than a label. */
export const QUEUE_STATUS_ORDER: readonly QueueStatus[] = [
  'waiting', 'reviewing', 'clarifying', 'addressing_private', 'clearing', 'settled',
];

/**
 * The states a drain may legally be in for `next` to be its next move.
 *
 * Derived from the declared edges rather than restated, so the machine above is the only place the
 * workflow is written down. This is what the conditional write conditions ON: a stage is refused
 * unless the record currently holds a state that actually leads to it.
 */
export function statesThatMayPrecede(next: QueueStatus): QueueStatus[] {
  return (Object.keys(QUEUE_DRAIN_MACHINE.states) as QueueStatus[])
    .filter((from) => (QUEUE_DRAIN_MACHINE.states[from]?.transitions ?? []).includes(next));
}


/**
 * What a person reads for a stage.
 *
 * The words the deployment chose over the `queue-status` message template's shipped label, the same shape every
 * other line on this path uses: the words belong to the deployment and to the language the conversation is being
 * held in, not to this file.
 */


export function queueStatusLabel(status: QueueStatus, copy?: AssistantCopy): string {
  return configuredQueueStatusLabel(status, copy) || shippedLineText('queue-status', `label.${status}`);
}

/**
 * The words a DEPLOYMENT chose for a stage, or nothing.
 *
 * Separate from `queueStatusLabel` because the two answer different questions, and the client needs
 * this one. A stage travels to the client as a TOKEN so the client can render it in the language the
 * person is reading - which a fixed English label sent from here would defeat. But a deployment that
 * has deliberately worded a stage must not have that overridden by a translation, so its wording is
 * sent alongside and wins. Absent means "nobody chose words here", and the client uses its own.
 */
export function configuredQueueStatusLabel(
  status: QueueStatus,
  copy?: AssistantCopy,
): string | undefined {
  // Chosen words are the assistant's or the classification's `queue-status` template (ADR-062). The shipped
  // template is the client's own translation's job.
  const section = `label.${status}`;
  const { template, origin } = messageTemplateChoice('queue-status', { copy });
  if (origin !== 'assistant' && origin !== 'classification') return undefined;
  const label = template.messageSections?.[section];
  return label && label.trim() ? label : undefined;
}
