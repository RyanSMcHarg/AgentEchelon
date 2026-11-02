/**
 * WORKING THROUGH CLARIFICATIONS IS SOMETHING THE ASSISTANT OFFERS TO DO (maintainer, 2026-09-03).
 *
 * A clarification is a question the assistant asked and cannot answer itself, so it waits on a
 * person. Left there it waits forever: it sits in their list, and nothing brings it up again unless
 * they think to. The owner's rule closes that:
 *
 *   - work through them when there is no higher-priority or active work, because at that point the
 *     assistant has nothing better to do and the person gains a step for free;
 *   - and when priority is NOT clear, say that clarifications are outstanding and OFFER to work
 *     through them, rather than deciding for them.
 *
 * ── WHY IT RIDES THE DRAIN AND NOT A TIMER ──────────────────────────────────────────────────────
 *
 * Tenet D6 forbids a schedule, and it would be the wrong shape anyway: "the assistant has nothing more
 * urgent" is not a time, it is a state, and the moment it becomes true is the moment the queue
 * clears. That is an EVENT, the drain is already there, and it already has a message in front of the
 * person - so this costs no new trigger, no new signal and no second message.
 *
 * ── WHY OFFERING IS NOT THE SAME AS ASKING AGAIN ────────────────────────────────────────────────
 *
 * Re-asking each outstanding question would republish, in the room, what several people were asked
 * privately, and would be a nag rather than help. The offer names a COUNT and nothing else, the same
 * discipline the private-request count already follows: the fact that clarifications are outstanding
 * is not itself private, and what any of them says is.
 */

import type { TaskPriority } from './task-tracking.js';

/** The bare shape this decision needs. Deliberately not a `Task`, so it is trivially testable. */
export interface FollowUpCandidate {
  taskId: string;
  priority?: TaskPriority;
}

export type ClarificationFollowUp =
  /** Nothing outstanding, or something more urgent is genuinely open. Say nothing. */
  | { action: 'stay-quiet' }
  /** Nothing else is open: take them up now, without being asked. */
  | { action: 'work-through'; count: number }
  /** Something else is open and no order between them is established: say so and offer. */
  | { action: 'offer'; count: number };

const RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

/** Highest priority present, or `normal` when nothing declares one. */
function topPriority(items: FollowUpCandidate[]): number {
  return items.reduce((best, i) => Math.min(best, RANK[i.priority ?? 'normal']), RANK.low);
}

/**
 * Decide whether to work through outstanding clarifications, offer to, or stay quiet.
 *
 * @param clarifications Questions outstanding and waiting on a person.
 * @param otherActive Every other live task in this conversation - the work that could outrank them.
 */
export function decideClarificationFollowUp(
  clarifications: FollowUpCandidate[],
  otherActive: FollowUpCandidate[],
): ClarificationFollowUp {
  const count = clarifications.length;
  if (!count) return { action: 'stay-quiet' };

  // NOTHING ELSE IS OPEN, so there is nothing to be outranked BY. This is the case the owner's rule
  // names first, and it needs no comparison at all.
  if (!otherActive.length) return { action: 'work-through', count };

  const theirs = topPriority(clarifications);
  const others = topPriority(otherActive);

  // SOMETHING MORE URGENT IS GENUINELY OPEN. Interrupting it to raise a question that is not urgent
  // is the assistant deciding that its own housekeeping outranks the person's work.
  if (others < theirs) return { action: 'stay-quiet' };

  // THE CLARIFICATIONS OUTRANK WHAT IS OPEN, so taking them up is not an interruption.
  if (theirs < others) return { action: 'work-through', count };

  // EQUAL, WHICH IS "NOT CLEAR" RATHER THAN "TIED" (maintainer, 2026-09-03). Priority is recorded rather
  // than inferred, and most work carries the default - so equal ranks mean nothing established an
  // order between them, not that somebody weighed them and found them balanced. Choosing either way
  // would be inventing a decision, so it is put to the person instead.
  return { action: 'offer', count };
}
