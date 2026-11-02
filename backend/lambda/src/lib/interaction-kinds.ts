/**
 * WHAT KIND OF INTERACTION A TURN IS, named once (LATENCY-TARGETS.md G13).
 *
 * THE PROBLEM THIS SOLVES. "How long did this take" means something different depending on what
 * caused the turn. A person watching a placeholder is waiting; a rebuttal answering a rival is not;
 * a welcome nobody triggered has no wait at all. Measured against one metric they are incomparable,
 * and averaged into one number they are misleading - a duel-heavy day put the MAJORITY of assistant
 * messages into a bucket with no measured latency, because the only anchor the platform understood
 * was a user message.
 *
 * The vocabulary was `'user' | 'orchestrator'`, which named the two DISPATCHERS rather than the
 * interactions. Everything that was not a user message and not the battle orchestrator - a welcome, a
 * drift notice, a scheduled briefing, a task handover - declared nothing at all, and an absent
 * trigger is read as `user`. So those turns were not merely unmeasured, they were counted as if a
 * person had been waiting for them.
 *
 * ── THE TWO HALVES, AND WHY BOTH ARE NEEDED ──
 *
 * `InteractionKind` says WHAT the turn is. `triggerAt` says WHEN the thing that caused it happened.
 * A kind without an instant cannot be measured; an instant without a kind cannot be compared to the
 * right expectation. Both are DECLARED by the producer that knows them, never inferred downstream -
 * the same rule `respPhase` already follows, and for the same reason: an inference made at read time
 * is a second opinion that can disagree with the truth and never errors when it does.
 *
 * ── ABSENT IS NOT ZERO ──
 *
 * A producer that cannot honestly supply `triggerAt` supplies nothing, and the metric is NULL for
 * that turn. A fabricated instant would report the fastest possible reaction for exactly the turns
 * nobody understands, which is the failure mode the derived-anchor bound already guards against.
 */

/**
 * The interactions this platform produces. Each is a DIFFERENT question about latency, which is the
 * test for whether something belongs here: if two entries would always be read against the same
 * expectation, they are one entry wearing two names.
 */
export const INTERACTION_KINDS = [
  /** A person sent a message and is watching for a reply. */
  'user',
  /**
   * Battle round 2: a rebuttal to the rival's answer. Triggered at the duel's last round-1 terminal
   * state, the instant round two is triggered, not by a person.
   */
  'rebuttal',
  /** A turn handed to the assistant that owns the task. The person is still waiting, upstream. */
  'handover',
  /** Post-processing repaired an unaddressed task answer. The person is still waiting, from before. */
  'repair',
  /**
   * A turn died and its retries were spent, so the assistant is saying so.
   *
   * The person is still waiting, and has been since before the turn that failed - this line is the
   * first feedback they get, which is exactly what time-to-first-feedback measures.
   */
  'recovery',
  /**
   * A person was added to a conversation and the room's assistant catches them up, privately
   * (`lib/join-recap.ts`). Nobody asked and nobody is watching for it, so no response-time limit applies.
   */
  'join_recap',
  /**
   * A `prompt` welcome's one model turn (SPEC-WELCOME-AND-CONTEXT FR24): the joining assistant greets the room after
   * its structured opening, from its version's prompt template. Nobody asked and nobody is waiting on it.
   */
  'welcome',
  /** An event workflow's `agent` step (ADR-061 decision 8): a turn nobody asked for and nobody is waiting on. */
  'event_step',
  /** An idle assistant taking up a task assigned to it (ADR-063 decision 5): a turn nobody asked for at that moment. */
  'task_step',
  /**
   * The room's primary naming a room another assistant answered first (`lib/room-naming.ts`): one title derivation on
   * the primary's own session, which posts nothing and which nobody is waiting on.
   */
  'name_room',
] as const;

/**
 * ONLY WHAT A PRODUCER ACTUALLY DECLARES, and the omissions are deliberate.
 *
 * `welcome` is here for the one welcome a model writes: the `prompt` welcome's turn, which the processor runs and
 * declares. The structured opening the router returns to Lex runs no model, and declares its kind in its content.
 * A drift offer and a scheduled briefing are real messages that do not belong here, because neither is a turn
 * with compute to attribute:
 *
 *   drift     - the offer to split a conversation is delivered INSIDE the turn that drifted, which is
 *               a user message somebody sent and is waiting on. It is a user turn whose content is an
 *               offer, and naming it separately would split one interaction into two.
 *   briefing  - posted directly to the channel on a schedule; again no model turn behind it.
 *
 * Adding them as values nothing emits would be the inert-mechanism shape this repo keeps finding: a
 * vocabulary that looks complete, a console that offers filters returning nothing, and no error
 * anywhere. When one of those paths grows a model turn, it gets a value AND a producer in the same
 * change - never a value first.
 */

export type InteractionKind = (typeof INTERACTION_KINDS)[number];

/**
 * Kinds a PERSON is waiting on, so time-to-first-feedback stays comparable to the published
 * response-time limits.
 *
 * `handover` and `repair` are here and `rebuttal` is not, which is the whole distinction: a handover
 * and a repair both start from a real message somebody sent and is waiting on - they were simply
 * routed badly - so the wait is real and the Nielsen bands apply. A rebuttal answers another
 * assistant; nobody is watching for it.
 */
const HUMAN_IS_WAITING: ReadonlySet<string> = new Set<InteractionKind>([
  'user', 'handover', 'repair', 'recovery',
]);

/** True when a person is waiting on this turn, so the perceived-latency SLO applies to it. */
export function isHumanWaiting(kind: string | null | undefined): boolean {
  // Absent reads as `user`, which is what every path did before a trigger was forwarded at all.
  // Preserved deliberately: changing the default would silently reclassify historical rows.
  return kind == null || kind === '' || HUMAN_IS_WAITING.has(kind);
}

/** Whether a string is one of the declared kinds (an unknown value is data, not a crash). */
export function isInteractionKind(v: unknown): v is InteractionKind {
  return typeof v === 'string' && (INTERACTION_KINDS as readonly string[]).includes(v);
}

/**
 * The legacy dispatcher names, mapped onto the interactions they actually were.
 *
 * Rows written before this vocabulary existed carry `orchestrator` for BOTH a rebuttal and a repair,
 * which cannot be separated after the fact - so it maps to the one it was overwhelmingly used for,
 * and the ambiguity is recorded here rather than papered over. New producers declare the specific
 * kind, so this only ever applies to history.
 */
export function normaliseLegacyTrigger(v: string | null | undefined): InteractionKind | null {
  if (v == null || v === '') return null;
  if (isInteractionKind(v)) return v;
  if (v === 'orchestrator') return 'rebuttal';
  return null;
}

/**
 * Kinds that ANSWER NO MESSAGE, so a turn of one is never paired as the reply to a message.
 *
 * A join recap is said to a person because they were added, not because they wrote anything: the
 * message before it in the room is someone else's, or the new member's from another day. Paired by
 * adjacency it would be filed as the answer to that message, at whatever gap separated the two, and the
 * evaluation runner would then judge it against a question it never answered. Archival records the kind
 * as the turn's `turn_kind` (`kinesis-archival.ts`), and both pairing paths skip any row that carries one.
 *
 * A rebuttal is deliberately absent: it pairs with the person's message the duel began from, as its own
 * round, and is measured from its own trigger (migration 071).
 */
export const ANSWERS_NO_MESSAGE_KINDS: readonly InteractionKind[] = ['join_recap', 'welcome', 'event_step', 'task_step'];
const ANSWERS_NO_MESSAGE: ReadonlySet<string> = new Set<string>(ANSWERS_NO_MESSAGE_KINDS);

/** True when a turn of this kind answers no message, so it is never an exchange. */
export function answersNoMessage(kind: string | null | undefined): boolean {
  return typeof kind === 'string' && ANSWERS_NO_MESSAGE.has(kind);
}
