/**
 * WHERE A DUEL'S SCORECARD RENDERS, as a pure function.
 *
 * A battle's scorecard belongs at the END of the duel - after every round - so a multi-round battle
 * does not show its result wedged between rounds. The anchor therefore has to answer one question:
 * which message is the LAST one of this battle?
 *
 * THE BUG THIS EXISTS TO PREVENT, and it shipped. The rule was "the next message has a different
 * battleId", which finds the last message of a CONTIGUOUS RUN. A duel's messages are only contiguous
 * when nothing interleaves, and plenty does: the person can speak mid-duel, a second `/battle` is
 * refused with an explained no-op, round 2 arrives after both. Every interleaved message split one
 * duel into two blocks - and because the scorecard's contents are filtered from ALL messages by
 * battleId rather than from the block, each block rendered the SAME scorecard again.
 *
 * Measured live: three scorecards for one duel, in the single-active-battle e2e - the one test that
 * deliberately interleaves a refusal into a running duel, which is why it is the one that caught it.
 * It had failed once before without being root-caused, and was filed with "do not file this as flaky
 * and move on" precisely so the second occurrence would be diagnosed instead of re-run.
 *
 * EXTRACTED FROM THE COMPONENT so the rule can be exercised without standing up the conversation view
 * and its providers. The defect is in the RULE, and a rule that can only be tested through a rendered
 * tree is one that does not get tested.
 */

import { continuationParentId } from '../utils/continuationOrder';

/** The shape this rule needs, and nothing more: a message may belong to a battle. */
export interface BattleAnchorable {
  id?: string;
  battle?: { battleId?: string; round?: number } | null;
  continuation?: boolean;
  parentMessageId?: string;
}

/**
 * The battle a message belongs to, INCLUDING a continuation part of a battle answer.
 *
 * An answer longer than one message is posted as the answer plus continuation parts, and only the
 * answer carries the battle marker. Read alone, the tail of a long round-1 answer looks like a
 * message outside the duel: the round-2 divider never renders, because the message before round 2 is
 * the tail rather than a round-1 answer, and the scorecard renders above the tail of a long final
 * rebuttal. Both were seen on a live run. A part belongs to the message it continues.
 */
export function battleOf<T extends BattleAnchorable>(
  m: T | null | undefined,
  byId: ReadonlyMap<string, T>,
): T['battle'] | undefined {
  if (!m) return undefined;
  if (m.battle) return m.battle;
  const parent = continuationParentId(m);
  if (parent) return byId.get(parent)?.battle ?? undefined;
  return undefined;
}

/** Whether a "Round 2 - rebuttals" divider renders above `message`: round 1 of this duel ends just before it. */
export function opensRound2<T extends BattleAnchorable>(
  message: T,
  prev: T | null | undefined,
  byId: ReadonlyMap<string, T>,
): boolean {
  const before = battleOf(prev, byId);
  return message.battle?.round === 2
    && !!message.battle.battleId
    && before?.battleId === message.battle.battleId
    && before.round === 1;
}

/** Messages keyed by id, the lookup `battleOf` resolves a continuation's parent through. */
export function messagesById<T extends BattleAnchorable>(messages: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const m of messages) if (m.id) map.set(m.id, m);
  return map;
}

/**
 * Index of the LAST message of each battle, keyed by battleId.
 *
 * Later entries overwrite earlier ones, so a single forward pass leaves each key holding the highest
 * index - which is the definition of "last" in render order. Messages with no battle are skipped
 * rather than mapped to a sentinel: absence is what "not part of a duel" means here.
 *
 * Precomputed as a map instead of asking "is there a later message with this battleId" inside the
 * render loop, which would be quadratic on a long conversation for a question with one answer.
 */
export function lastMessageIndexByBattleId<T extends BattleAnchorable>(
  messages: readonly T[],
  /** The caller's own id map when it already built one, so a render builds it once. */
  byId: ReadonlyMap<string, T> = messagesById(messages),
): Map<string, number> {
  const map = new Map<string, number>();
  messages.forEach((m, i) => {
    const id = battleOf(m, byId)?.battleId;
    if (id) map.set(id, i);
  });
  return map;
}
