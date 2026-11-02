/**
 * WHICH OPEN PIECE OF WORK A PLAIN REPLY IS ABOUT (ADR-024, ADR-024 D7).
 *
 * When somebody answers from the work item itself the client addresses the reply with
 * `Metadata.task.id` and there is nothing to work out. This is the other case: an ordinary message,
 * sent while more than one piece of their work is open, and nothing in the message says which.
 *
 * ── WHAT WAS WRONG WITH THE OLD ANSWER ──────────────────────────────────────────────────────────
 *
 * `getAssigneeChannelTasks(...).live[0]` is newest-first, and the router resumed that one. Holding more
 * than one open piece of work is ordinary rather than exotic - a long request opens a
 * `report_generation` in `collecting_requirements`, and a queued message can open a
 * `queued_clarification` in `asked` - so an unaddressed reply went to whichever was newer.
 *
 * Measured on the turn-queue e2e: of fourteen answers applied, TWELVE went to
 * `collecting_requirements` and one to `asked`. The clarification the assistant had just asked about
 * stayed open while the person believed they had answered it.
 *
 * Recency is not evidence. It is the arrival order of the WORK, and the question is which work the
 * MESSAGE is about - a fact about the message, which recency cannot see.
 *
 * ── AWAITING IS WEAK EVIDENCE, NOT STRONG (maintainer, 2026-09-04) ────────────────────────────────────
 *
 * The runtime treated `awaits` as the license to read a message as an answer, which quietly makes it
 * the strongest signal available: a state saying "I am blocked on this person" became "the next thing
 * this person says is the answer". The owner's rule inverts that ranking - a task the assistant is
 * ACTIVELY working is a MORE likely referent than one parked awaiting a reply.
 *
 * That reads oddly for one turn and is right over a conversation. A question just asked is answered
 * or it is not; a question parked for a while is one the person may well have moved on from, while
 * work actually in flight is the live thread between them. `awaits` licenses reading a message as an
 * answer. It never established that THIS message is one.
 *
 * ── SO THE ASSISTANT DETERMINES IT, AND ASKS WHEN IT CANNOT ──────────────────────────────────────
 *
 * The runtime ranks and proposes; it does not decide. Deciding needs the message's words, and the
 * only place holding those alongside the open work is the turn. So the candidates travel to the turn,
 * the model names the one the message is about, and when it cannot tell it ASKS rather than picking.
 *
 * The alternative - keep guessing, and let a wrong guess be corrected later - is not symmetric. A
 * guess advances a machine, and a state advanced by a message that did not address it is a step
 * nobody completed. Asking costs a sentence.
 *
 * This is the same shape the drain already uses for the same class of problem: rank deterministically,
 * let the model make the judgement that needs the words, and give it `unclear` as a first-class answer
 * so it never has to invent one.
 */

import type { TaskStateMachine } from './task-state-machines.js';
// From the visibility module rather than the task store, so this stays a light module with no runtime
// edge to the store, and reads absence by the same rule every other reader uses.
import { isPrivateVisibility, type TaskVisibility } from './task-visibility.js';
import { awaitedPartyOf, legalTransitionsFrom } from './task-state-machines.js';

/**
 * One piece of open work a message might be about.
 *
 * Deliberately NOT `UserTask`: this carries only what a ranking and a prompt need, so the module can
 * be exercised without a store and a caller cannot pass a row through to a prompt by accident.
 */
export interface ReferentCandidate {
  taskId: string;
  taskType: string;
  taskState?: string;
  /** The reference the person types for this item (ADR-035). */
  taskRef?: number;
  /** The person's own words, already truncated at creation (ADR-024 D5). */
  requestExcerpt?: string;
  visibility?: TaskVisibility;
  /** Whose work it is, so this assistant's own chain can be told from another's. */
  assistantId?: string;
  updatedAt?: string;
}

/** How many candidates are worth naming to the model, newest-first after ranking. */
export const MAX_REFERENT_CANDIDATES = 5;

/**
 * Order the candidates, best referent first.
 *
 * THE ORDER IS A PROPOSAL, NOT A DECISION. Its job is to put the likeliest first so the provisional
 * pick is usually right and the model usually agrees; the model still names the one it reads the
 * message as addressing, and may name another.
 */
export function rankReferentCandidates(
  candidates: ReferentCandidate[],
  args: {
    /** This assistant, as a principal id. */
    assistantId: string;
    machines: Record<string, TaskStateMachine>;
  },
): ReferentCandidate[] {
  const awaiting = (c: ReferentCandidate): boolean => Boolean(
    c.taskState && awaitedPartyOf(args.machines[c.taskType]?.states?.[c.taskState]),
  );
  return [...(candidates ?? [])].sort((a, b) => {
    // 1. THIS ASSISTANT'S OWN CHAIN FIRST, which is an ownership rule rather than a likelihood one and
    //    therefore outranks both of the others. Two duel sides can wait on the same person at once, so
    //    without it a side could read its rival's question as the one it just got answered.
    const mine = (c: ReferentCandidate) => (c.assistantId === args.assistantId ? 0 : 1);
    if (mine(a) !== mine(b)) return mine(a) - mine(b);
    // 2. ACTIVE BEFORE AWAITING (maintainer, 2026-09-04). Work in flight is the live thread between them;
    //    a parked question is one they may have moved on from.
    //
    //    THIS IS WHY THE CANDIDATES ARE READ BY OWNER (ADR-024 D8). Fed from the assignee partition,
    //    as it was first, this comparison separates nothing: a person is the assignee only while a
    //    step awaits them, so every candidate would be parked and the rule would be inert. The owner
    //    holds still while the assistant works, which is what puts work in flight in the list at all.
    const parked = (c: ReferentCandidate) => (awaiting(c) ? 1 : 0);
    if (parked(a) !== parked(b)) return parked(a) - parked(b);
    // 3. RECENCY LAST, and only as a tiebreak between things the rules above cannot separate. It is
    //    what this used to decide on outright, which is the defect; as a final tiebreak it is merely
    //    a stable order rather than a claim.
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });
}

/** A short handle for a candidate, taken from the person's own words rather than invented. */
function handleFor(c: ReferentCandidate): string {
  // A PRIVATE ROW IS NAMED, NEVER DESCRIBED. The reply this turn produces is conversation-visible, so
  // an excerpt reaching the prompt is an excerpt that can reach the room. The person can still tell
  // their own private request apart from their report by its type and state, which is what a chooser
  // needs; what it asked for is not needed to choose between two of them.
  if (isPrivateVisibility(c.visibility)) return 'a private request of theirs';
  const words = (c.requestExcerpt ?? '').replace(/\s+/g, ' ').trim();
  if (!words) return c.taskType.replace(/_/g, ' ');
  return words.length > 80 ? `${words.slice(0, 80)}...` : words;
}

/**
 * The prompt block naming what this message might be about.
 *
 * Returns '' when there is nothing to choose between - one candidate, or none. A hint that appears on
 * every turn teaches the model to ask on turns where nothing was ambiguous, which is the failure this
 * is meant to remove pointing the other way.
 */
export function buildReferentHint(
  ranked: ReferentCandidate[],
  args: { provisionalTaskId?: string; machines: Record<string, TaskStateMachine> },
): string {
  const candidates = (ranked ?? []).slice(0, MAX_REFERENT_CANDIDATES);
  if (candidates.length < 2) return '';

  const line = (c: ReferentCandidate): string => {
    const state = c.taskState ? ` (${c.taskState})` : '';
    const awaits = c.taskState
      && awaitedPartyOf(args.machines[c.taskType]?.states?.[c.taskState])
      ? ' - parked, waiting on them'
      : ' - in flight';
    const mark = c.taskId === args.provisionalTaskId ? ' [assumed]' : '';
    // ── WHERE EACH ONE CAN GO, VERBATIM (live evidence, 2026-09-04) ─────────────────────────────
    //
    // Named for the same reason `taskAdvanceHint` names them for the active task: without the exact
    // targets the model guesses a `to_state`, and a guess outside the declared graph is refused.
    //
    // It matters MORE on this list, which is how it was found. These candidates are different TYPES
    // with different machines - a `queued_clarification` in `asked` beside a `report_generation` in
    // `collecting_requirements` - so a model that redirected was reading the ASSUMED task's states
    // and applying them to another machine.
    //
    // Observed live: the redirect landed correctly, the tool answered `illegal_transition`, and that
    // spent the LAST of the three tool iterations. The tool already echoes `legal_transitions` so a
    // model can self-correct in the same loop - it simply had no iteration left to do it in, so the
    // turn produced no text and the person got the generic fallback line instead of the answer.
    //
    // Which is why this belongs in the PROMPT rather than only in the tool's error: recovering costs
    // an iteration, and there are three.
    const legal = c.taskState ? legalTransitionsFrom(c.taskType, c.taskState, args.machines) : [];
    const goes = legal.length
      ? `; can move to ${legal.map((t) => `\`${t}\``).join(' or ')}`
      : '';
    const ref = c.taskRef ? `#${c.taskRef} ` : '';
    return `- \`${c.taskId}\` ${ref}${handleFor(c)}${state}${awaits}${goes}${mark}`;
  };

  return `
## MORE THAN ONE PIECE OF THEIR WORK IS OPEN

This message did not say which of these it is about, and they all belong to the person you are
talking to:

${candidates.map(line).join('\n')}

Work out which one this message is about, from what they actually said. Then either:

- name it in \`task_id\` when you call \`advance_task_state\`, so the right one moves - and take
  \`to_state\` from THAT item's own "can move to" list above, never from the one the turn started on:
  these are different kinds of work and their states are not interchangeable; or
- if you genuinely cannot tell, ASK them which they meant - in your own words, naming the choices -
  and do not advance anything this turn. Name each choice by its reference (\`#2\`) where it has one,
  and tell them to start their reply with it: that settles which item a reply answers.

Asking is the correct answer when you cannot tell. Guessing advances a step nobody completed, and
they have to notice that and undo it; asking costs one sentence.

The one marked [assumed] is only the runtime's ordering - work in flight ranks above a parked
question - and it is a starting point, not an answer. Prefer what the message says over that order.

Do not quote the contents of a private request: this reply is visible to the conversation.
`;
}
